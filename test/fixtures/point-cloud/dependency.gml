<?xml version="1.0" encoding="UTF-8"?>
<!-- Invented geometry only. LAS lon/lat and GML lat/lon share one origin and original heights. -->
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:gml="http://www.opengis.net/gml"
  xmlns:gen="http://www.opengis.net/citygml/generics/2.0" xmlns:uro="https://www.geospatial.jp/iur/uro/3.2">
  <core:cityObjectMember><gen:GenericCityObject gml:id="synthetic-las">
    <uro:pointCloud><uro:PointCloud><uro:lod>1</uro:lod><uro:pointFile>cloud0.las</uro:pointFile></uro:PointCloud></uro:pointCloud>
  </gen:GenericCityObject></core:cityObjectMember>
  <core:cityObjectMember><gen:GenericCityObject gml:id="synthetic-laz">
    <uro:pointCloud><uro:PointCloud><uro:lod>1</uro:lod><uro:pointFile>cloud7.laz</uro:pointFile>
      <uro:pointFileSrsName>EPSG:4326</uro:pointFileSrsName>
    </uro:PointCloud></uro:pointCloud>
  </gen:GenericCityObject></core:cityObjectMember>
  <core:cityObjectMember><gen:GenericCityObject gml:id="same-origin-line">
    <gen:lod1Geometry><gml:LineString srsName="EPSG:6697" srsDimension="3"><gml:posList>35 135 -4 35.0004 135.00025 28</gml:posList></gml:LineString></gen:lod1Geometry>
  </gen:GenericCityObject></core:cityObjectMember>
</core:CityModel>
